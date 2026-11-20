/**
 * Fasteners (docs/plan-mech-parts.md milestone 1) through the MCP server against real Open CASCADE.
 * solid_new of each default, model_describe's mesh box against the analytic box, model_check edges, one boolean,
 * and the refusals. Skips when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
 *
 * Prints measured volume and bounds against the analytic solid. The rows below are the plan's, not the builder's.
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
    console.error("part: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("part: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-part-"));
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "25";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail.slice(0, 1500)}` : ""}`);
}

type Reply = Record<string, unknown>;
const session = new Session(loadEngineWorker(root));
const call = async (name: string, args: unknown = {}) => (await session.call(name, args)) as Reply;
const show = (value: unknown) => JSON.stringify(value);

await call("project_create", {});

const guide = await call("guide", { topic: "ops", section: "part" });
const guideText = String(guide.text ?? "");
check(
  "guide {topic:ops, section:part} has the four tables and the thread sentence",
  guide.ok === true && guideText.includes("ISO 4032") && guideText.includes("ISO 4762") && guideText.includes("ISO 4017") && guideText.includes("ISO 7089") && guideText.includes("A modelled thread is not available yet. Use tap drill."),
  show(guide),
);
check(
  "guide {topic:ops, section:part} has the fittings and the Ruthex table",
  guideText.includes("RX-M3x5,7") && guideText.includes("RX-M8x12,7") && guideText.includes("centred on −Y") && guideText.includes("lime_recipe::horology::shaft"),
  guideText.slice(guideText.indexOf("Fittings"), guideText.indexOf("Fittings") + 400),
);

const hexArea = (s: number) => (Math.sqrt(3) / 2) * s * s;
const cylinder = (radius: number, height: number) => Math.PI * radius * radius * height;

/** Plan rows at the default (M6), with the default length under the head. */
const rows: { kind: string; nominal: string; volume: number; box: [[number, number, number], [number, number, number]] }[] = [
  {
    kind: "nut",
    nominal: "M6",
    volume: hexArea(10) * 5.2 - cylinder(2.5, 5.2),
    box: [[-10 / Math.sqrt(3), -5, 0], [10 / Math.sqrt(3), 5, 5.2]],
  },
  {
    kind: "socket",
    nominal: "M6",
    volume: cylinder(5, 6) + cylinder(3, 25) - hexArea(5) * 3,
    box: [[-5, -5, -25], [5, 5, 6]],
  },
  {
    kind: "hex",
    nominal: "M6",
    volume: hexArea(10) * 4 + cylinder(3, 20),
    box: [[-10 / Math.sqrt(3), -5, -20], [10 / Math.sqrt(3), 5, 4]],
  },
  {
    kind: "washer",
    nominal: "M6",
    volume: Math.PI * (6 * 6 - 3.2 * 3.2) * 1.6,
    box: [[-6, -6, 0], [6, 6, 1.6]],
  },
];

function nearBox(got: { min?: number[]; max?: number[] } | undefined, want: [[number, number, number], [number, number, number]]): boolean {
  if (!got?.min || !got.max) return false;
  return [got.min, got.max].every((side, i) => side.every((value, axis) => Math.abs(value - want[i]![axis]!) < 0.02));
}

for (const row of rows) {
  const made = await call("solid_new", { primitive: "part", kind: row.kind, nominal: row.nominal, name: row.kind });
  const object = String(made.object ?? "");
  const described = object ? await call("model_describe", { object, limit: 0 }) : {};
  const volume = Number(described.volumeMm3);
  const bounds = described.bounds as { min?: number[]; max?: number[] } | undefined;
  console.log(`part ${row.kind} ${row.nominal}: measured volume ${volume} mm3, analytic ${row.volume} mm3, measured bounds ${show(bounds)}, analytic bounds ${show(row.box)}`);
  check(`solid_new ${row.kind}`, made.ok === true, show(made));
  check(`${row.kind} volume within 0.5 mm3`, Math.abs(volume - row.volume) < 0.5, show(described));
  check(`${row.kind} bounds within 0.02 mm`, nearBox(bounds, row.box), show(bounds));
  const checked = await call("model_check", { object });
  check(`${row.kind} is closed`, JSON.stringify(checked.edges) === JSON.stringify({ open: 0, nonManifold: 0 }), show(checked.edges));
}

const washer = await call("solid_new", { primitive: "part", kind: "washer", nominal: "M12", name: "washer" });
const cut = await call("model_apply", {
  object: washer.object,
  probe: true,
  op: { kind: "boolean", op: "cut", primitive: "part", partKind: "nut", nominal: "M12" },
});
const cutCheck = await call("model_check", { object: washer.object });
console.log(`M12 washer cut by an M12 nut: ${show({ ok: cut.ok, edges: cutCheck.edges })}`);
check("a washer cut by a nut stays closed", cut.ok === true && JSON.stringify(cutCheck.edges) === JSON.stringify({ open: 0, nonManifold: 0 }), show({ cut, edges: cutCheck.edges }));

const unknown = await call("solid_new", { primitive: "part", kind: "nut", nominal: "M7" });
const sentence = String(unknown.reason ?? unknown.message ?? show(unknown));
check("M7 names the ISO 4032 table", unknown.ok === false && sentence.includes("M7 is not in the ISO 4032 style 1 hex nut table."), show(unknown));

const thread = await call("solid_new", { primitive: "part", kind: "nut", nominal: "M6", boreKind: "thread" });
check("a modelled thread is refused", thread.ok === false && String(thread.reason ?? "").includes("A modelled thread is not available yet. Use tap drill."), show(thread));

const shaftD = 8 - 0.012 - 0.1;
const fittings: { name: string; args: Record<string, unknown>; volume: number | null; box: [[number, number, number], [number, number, number]] }[] = [
  { name: "spacer", args: { kind: "spacer" }, volume: Math.PI * (5 * 5 - 2.1 * 2.1) * 12, box: [[-5, -5, 0], [5, 5, 12]] },
  { name: "shaft", args: { kind: "shaft" }, volume: Math.PI * (shaftD / 2) ** 2 * 40, box: [[-shaftD / 2, -shaftD / 2, 0], [shaftD / 2, shaftD / 2, 40]] },
  { name: "collar", args: { kind: "collar" }, volume: null, box: [[-7, -7, 0], [7, 7, 6]] },
  { name: "heat-set", args: { kind: "heat-set" }, volume: Math.PI * (3.9 * 3.9 - 2 * 2) * 5.7, box: [[-3.9, -3.9, 0], [3.9, 3.9, 5.7]] },
];
for (const row of fittings) {
  const made = await call("solid_new", { primitive: "part", ...row.args, name: row.name });
  const object = String(made.object ?? "");
  const described = object ? await call("model_describe", { object, limit: 0 }) : {};
  const volume = Number(described.volumeMm3);
  const bounds = described.bounds as { min?: number[]; max?: number[] } | undefined;
  console.log(`part ${row.name}: measured volume ${volume} mm3, analytic ${row.volume ?? "tube, after the cuts"} mm3, measured bounds ${show(bounds)}, analytic bounds ${show(row.box)}`);
  check(`solid_new ${row.name}`, made.ok === true, show(made));
  if (row.volume !== null) check(`${row.name} volume within 0.5 mm3`, Math.abs(volume - row.volume) < 0.5, show(described));
  check(`${row.name} bounds within 0.02 mm`, nearBox(bounds, row.box), show(bounds));
  const checked = await call("model_check", { object });
  check(`${row.name} is closed`, JSON.stringify(checked.edges) === JSON.stringify({ open: 0, nonManifold: 0 }), show(checked.edges));
}

const plate = await call("solid_new", { primitive: "box", dx: 30, dy: 30, dz: 4, name: "plate" });
const fused = await call("model_apply", {
  object: plate.object,
  probe: true,
  op: { kind: "boolean", op: "fuse", primitive: "part", partKind: "spacer" },
});
const fusedCheck = await call("model_check", { object: plate.object });
console.log(`plate fused with a spacer: ${show({ ok: fused.ok, edges: fusedCheck.edges, volume: fusedCheck.volumeMm3 })}`);
check("a plate fused with a spacer stays closed", fused.ok === true && JSON.stringify(fusedCheck.edges) === JSON.stringify({ open: 0, nonManifold: 0 }), show({ fused, edges: fusedCheck.edges }));

if (failed > 0) {
  console.error(`part: ${failed} failed`);
  process.exit(1);
}
console.log("part: ok");
process.exit(0);
