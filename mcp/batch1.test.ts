/**
 * Settings, face and edge selectors, and the guide prompts.
 * These fail when a key is dropped, a centre is missing, or a prompt names a tool the guide does not.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine } from "./engine.ts";
import { GUIDES } from "./guides.ts";
import { handleRpc } from "./protocol.ts";
import { Session } from "./session.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-batch1-"));
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

function near(value: unknown, expected: number): boolean {
  return typeof value === "number" && Math.abs(value - expected) < 0.05;
}

const engine = fakeEngine();
const session = new Session(engine);
const call = (name: string, args: unknown = {}) => session.call(name, args);

const made = await call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10 });
const object = String(made.object);

const dry = await call("settings_set", { values: { layerHeight: 0.16 }, dryRun: true });
check("a dry run names the change and writes nothing", dry.ok === true && dry.dryRun === true, JSON.stringify(dry));
const still = await call("settings_schema", { query: "layer height" });
const stillRows = still.rows as { key: string; value: unknown }[];
check("a dry run leaves layer height", stillRows.some((row) => row.key === "layerHeight" && row.value === 0.2), JSON.stringify(stillRows));

const mixed = await call("settings_set", { values: { layerHeight: 0.9, supports: true } });
const refused = mixed.refused as { key: string; reason: string }[];
const changed = mixed.changed as { key: string; to: unknown }[];
check(
  "an out of range key is refused and a sibling still applies",
  mixed.ok === true && refused.some((row) => row.key === "layerHeight" && row.reason === "Layer height must be from 0.08–0.4 mm.") && changed.some((row) => row.key === "supports" && row.to === true),
  JSON.stringify(mixed),
);

const iron = await call("settings_set", { values: { ironing: true, ironingSpeed: 15 } });
check("ironing and its speed are set together", iron.ok === true && !(iron.warnings as unknown[] | undefined)?.length, JSON.stringify(iron));
const schema = await call("settings_schema", { query: "ironing" });
const rows = schema.rows as { key: string; value: unknown; dependsOn?: string }[];
check(
  "the schema shows ironing and the speed that depends on it",
  rows.some((row) => row.key === "ironing" && row.value === true) && rows.some((row) => row.key === "ironingSpeed" && row.value === 15 && row.dependsOn === "ironing"),
  JSON.stringify(rows),
);
const autoRows = (await call("settings_schema", { query: "gap", all: true })).rows as { key: string; value: unknown; default: unknown; help?: string }[];
const zGap = autoRows.find((row) => row.key === "supportZGapMm");
check("a support gap starts as null, which is Auto, and says so", zGap?.value === null && zGap?.default === null && /Auto/.test(zGap?.help ?? ""), JSON.stringify(zGap));
const zeros = await call("settings_set", { values: { supportZGapMm: 0, supportXyGapMm: 0, supportInterfaceLayers: 0 } });
const zeroTo = Object.fromEntries((zeros.changed as { key: string; to: unknown }[]).map((row) => [row.key, row.to]));
check("a 0 is a real 0, and 0 interface layers read back as 1", zeros.ok === true && zeroTo.supportZGapMm === 0 && zeroTo.supportXyGapMm === 0 && zeroTo.supportInterfaceLayers === 1, JSON.stringify(zeros));
const backToAuto = await call("settings_set", { values: { supportZGapMm: null, supportXyGapMm: null, supportInterfaceLayers: null } });
check("null puts a support gap back to Auto", backToAuto.ok === true && (backToAuto.changed as { to: unknown }[]).every((row) => row.to === null), JSON.stringify(backToAuto));
const bridgeRows = (await call("settings_schema", { query: "bridge", all: true })).rows as { key: string; value: unknown; default: unknown; min?: number; help?: string }[];
const flowRow = bridgeRows.find((row) => row.key === "bridgeFlowRatio");
check("bridge flow starts as null, which is Auto, from 0.2", flowRow?.value === null && flowRow?.default === null && flowRow?.min === 0.2 && /Auto: 1/.test(flowRow?.help ?? ""), JSON.stringify(flowRow));
const lowFlow = await call("settings_set", { values: { bridgeFlowRatio: 0.1 } });
check("a bridge flow under 0.2 is refused, not clamped", lowFlow.ok === false && /0\.2–2/.test(String(lowFlow.reason ?? JSON.stringify(lowFlow))), JSON.stringify(lowFlow));
const zeroFan = await call("settings_set", { values: { bridgeFanPercent: 0 } });
check("a bridge fan of 0 is refused: null is Auto", zeroFan.ok === false, JSON.stringify(zeroFan));
const bridgeSet = await call("settings_set", { values: { bridgeFlowRatio: 0.9, bridgeSpeedMmS: 20, bridgeFanPercent: 80 } });
check("bridge values in range are set", bridgeSet.ok === true, JSON.stringify(bridgeSet));
const bridgeAuto = await call("settings_set", { values: { bridgeFlowRatio: null, bridgeSpeedMmS: null, bridgeFanPercent: null } });
check("null puts the bridge tune back to Auto", bridgeAuto.ok === true && (bridgeAuto.changed as { to: unknown }[]).every((row) => row.to === null), JSON.stringify(bridgeAuto));
const notAuto = await call("settings_set", { values: { layerHeight: null } });
check("null is refused for a setting that has no Auto", notAuto.ok === false, JSON.stringify(notAuto));
const defaults = await call("settings_schema", {});
const defaultRows = defaults.rows as { key: string }[];
check("unchanged keys stay off the default page", !defaultRows.some((row) => row.key === "layerHeight"), JSON.stringify(defaultRows.map((row) => row.key)));

await call("slice_start", {});
const body = JSON.parse(engine.lastSlice) as { ironing?: { speed?: number } };
check("the slice body carries the ironing speed", body.ironing?.speed === 15, engine.lastSlice.slice(0, 400));

const perObject = await call("settings_set", { object, values: { infill: 0.2, layerHeight: 0.2 } });
const objectRefused = perObject.refused as { key: string; reason: string }[];
const objectChanged = perObject.changed as { key: string; to: unknown }[];
check(
  "per-object infill is kept and layer height stays plate-wide",
  perObject.ok === true && objectChanged.some((row) => row.key === "infill" && row.to === 0.2) && objectRefused.some((row) => row.key === "layerHeight" && row.reason === "This setting is plate-wide."),
  JSON.stringify(perObject),
);
await call("slice_start", { cancelRunning: true });
const plate = JSON.parse(engine.lastSlice) as { objects?: { settings?: { infill?: number } }[] };
check("the plate slice sends that infill", plate.objects?.[0]?.settings?.infill === 0.2, JSON.stringify(plate.objects?.[0]?.settings));

const top = await call("faces_find", { object, normal: [0, 0, 1] });
const faces = top.faces as { index: number; centre: number[]; kind: string; normal: number[] }[];
check(
  "the top face is the one whose normal points up",
  top.ok === true && top.frame === "part" && faces.length === 1 && faces[0]?.kind === "plane" && near(faces[0]?.centre[0] ?? 99, 0) && near(faces[0]?.centre[1] ?? 99, 0) && near(faces[0]?.centre[2] ?? 99, 10),
  JSON.stringify(top),
);

const vertical = await call("edges_find", { object, direction: [0, 0, 1], convex: true });
const edges = vertical.edges as { index: number; mid: number[]; start: number[]; end: number[]; dir: number[] }[];
check(
  "vertical edges come back with a mid, ends, and a direction",
  vertical.ok === true && edges.length === 4 && edges.every((edge) => near(Math.abs(edge.dir[2] ?? 0), 1) && near(edge.mid[2] ?? 0, 5) && edge.start && edge.end),
  JSON.stringify(vertical),
);

const fillet = await call("model_probe", { object, op: { kind: "fillet", edges: { select: { direction: [0, 0, 1] } }, size: 1 } });
const resolved = fillet.edges as number[];
check(
  "a fillet select resolves the same indexes",
  fillet.ok === true && resolved.length === 4 && resolved.every((index) => edges.some((edge) => edge.index === index)),
  JSON.stringify(fillet),
);

const guide = await session.resource("lime://guide/model");
const order = guide.tools as string[];
const text = String(guide.text);
let at = 0;
let ordered = true;
for (const tool of order) {
  const next = text.indexOf(tool, at);
  if (next < 0) ordered = false;
  at = next + tool.length;
}
check("the model guide names its tools in order", ordered && order[0] === "solid_new" && order.includes("faces_find"), text);

const prompt = await handleRpc(session, {
  jsonrpc: "2.0",
  id: 1,
  method: "prompts/get",
  params: { name: "hole-on-face", arguments: { object } },
});
const promptText = JSON.stringify(prompt);
const model = GUIDES.find((row) => row.uri === "lime://guide/model")!;
let cursor = 0;
let promptOrder = promptText.includes(object);
for (const tool of ["faces_find", "workplane_set", "model_probe", "model_apply", "model_commit"]) {
  const next = promptText.indexOf(tool, cursor);
  if (next < 0) promptOrder = false;
  cursor = next;
}
check("the hole prompt follows the model guide", promptOrder && model.tools.includes("faces_find"), promptText);

const listed = await handleRpc(session, { jsonrpc: "2.0", id: 2, method: "resources/list" });
check("guide resources are listed", JSON.stringify(listed).includes("lime://guide/slice") && JSON.stringify(listed).includes("lime://guide/calibrate"));

if (failed > 0) {
  console.error(`batch1: ${failed} failed`);
  process.exit(1);
}
console.log("batch1: ok");
