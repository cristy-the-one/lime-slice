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
check(
  "guide {topic:ops, section:part} says approximate GT2 groove and has the ISO 4183 V pulley table",
  guideText.includes("An approximate GT2 groove") && guideText.includes("ISO 4183") && guideText.includes("SPZ 8.5 2.0 9 12 8 80 63"),
  guideText.slice(guideText.indexOf("GT2"), guideText.indexOf("GT2") + 600),
);
check(
  "guide {topic:ops, section:part} has the ISO 273 table and the L-bracket",
  guideText.includes("ISO 273 medium clearance") && guideText.includes("M16 17.5") && guideText.includes("L-bracket") && guideText.includes("A free diameter has no allowance"),
  guideText.slice(guideText.indexOf("Brackets"), guideText.indexOf("Brackets") + 240),
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

const drilled = 4.5 + 0.2;
const brackets: { name: string; args: Record<string, unknown>; volume: number; box: [[number, number, number], [number, number, number]] }[] = [
  {
    name: "clearance-plate",
    args: { kind: "plate", holeFor: "M4" },
    volume: 80 * 60 * 4 - 4 * Math.PI * (drilled / 2) ** 2 * 4,
    box: [[-40, -30, 0], [40, 30, 4]],
  },
  {
    name: "l-bracket",
    args: { kind: "bracket", holeFor: "M4" },
    volume: 30 * 3 * (80 - 3) - 4 * Math.PI * (drilled / 2) ** 2 * 3,
    box: [[-20, -15, 0], [20, 15, 40]],
  },
];
for (const row of brackets) {
  const made = await call("solid_new", { primitive: "part", ...row.args, name: row.name });
  const object = String(made.object ?? "");
  const described = object ? await call("model_describe", { object, limit: 0 }) : {};
  const volume = Number(described.volumeMm3);
  const bounds = described.bounds as { min?: number[]; max?: number[] } | undefined;
  console.log(`part ${row.name}: measured volume ${volume} mm3, analytic ${row.volume} mm3, measured bounds ${show(bounds)}, analytic bounds ${show(row.box)}`);
  check(`solid_new ${row.name}`, made.ok === true, show(made));
  check(`${row.name} volume within 0.5 mm3`, Math.abs(volume - row.volume) < 0.5, show(described));
  check(`${row.name} bounds within 0.02 mm`, nearBox(bounds, row.box), show(bounds));
  const checked = await call("model_check", { object });
  check(`${row.name} is closed`, JSON.stringify(checked.edges) === JSON.stringify({ open: 0, nonManifold: 0 }), show(checked.edges));
}

const holed = await call("solid_new", { primitive: "part", kind: "plate", holeFor: "M4", name: "holed-plate" });
const nutOn = await call("model_apply", {
  object: holed.object,
  probe: true,
  op: { kind: "boolean", op: "fuse", primitive: "part", partKind: "nut", nominal: "M4", origin: [32, 22, 2] },
});
const nutCheck = await call("model_check", { object: holed.object });
console.log(`M4 nut fused onto the default plate: ${show({ ok: nutOn.ok, edges: nutCheck.edges, volume: nutCheck.volumeMm3 })}`);
check("an M4 nut fused onto the default plate stays closed", nutOn.ok === true && JSON.stringify(nutCheck.edges) === JSON.stringify({ open: 0, nonManifold: 0 }), show({ nutOn, edges: nutCheck.edges }));

const plate = await call("solid_new", { primitive: "box", dx: 30, dy: 30, dz: 4, name: "plate" });
const fused = await call("model_apply", {
  object: plate.object,
  probe: true,
  op: { kind: "boolean", op: "fuse", primitive: "part", partKind: "spacer" },
});
const fusedCheck = await call("model_check", { object: plate.object });
console.log(`plate fused with a spacer: ${show({ ok: fused.ok, edges: fusedCheck.edges, volume: fusedCheck.volumeMm3 })}`);
check("a plate fused with a spacer stays closed", fused.ok === true && JSON.stringify(fusedCheck.edges) === JSON.stringify({ open: 0, nonManifold: 0 }), show({ fused, edges: fusedCheck.edges }));

function gt2Radius(teeth: number): number {
  return (teeth * 2 / Math.PI - 0.508) / 2;
}

function angleApart(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d < 0) d += Math.PI * 2;
  return d > Math.PI ? Math.PI * 2 - d : d;
}

/** Extent along `beta`: R when that direction misses every groove, else the larger R·cos of the outside corners. */
function axisExtent(teeth: number, radius: number, beta: number): number {
  const alpha = Math.asin(0.705 / radius);
  let hit = false;
  let best = 0;
  for (let i = 0; i < teeth; i += 1) {
    const phi = (Math.PI * 2 * i) / teeth;
    if (angleApart(phi, beta) < alpha) {
      hit = true;
      best = Math.max(best, radius * Math.cos(angleApart(phi - alpha, beta)), radius * Math.cos(angleApart(phi + alpha, beta)));
    }
  }
  return hit ? best : radius;
}

function gt2Box(teeth: number, width: number): [[number, number, number], [number, number, number]] {
  const radius = gt2Radius(teeth);
  return [
    [-axisExtent(teeth, radius, Math.PI), -axisExtent(teeth, radius, -Math.PI / 2), 0],
    [axisExtent(teeth, radius, 0), axisExtent(teeth, radius, Math.PI / 2), width],
  ];
}

function gt2Volume(teeth: number, bore: number, width: number): number {
  const radius = gt2Radius(teeth);
  const a = 0.705;
  const area = a * Math.sqrt(radius * radius - a * a) + radius * radius * Math.asin(a / radius) - 2 * a * (radius - 0.75);
  return (Math.PI * radius * radius - teeth * area - Math.PI * (bore / 2) ** 2) * width;
}

const pulley = await call("solid_new", { primitive: "part", kind: "gt2", name: "gt2" });
const pulleyObject = String(pulley.object ?? "");
const pulleyDescribed = pulleyObject ? await call("model_describe", { object: pulleyObject, limit: 0 }) : {};
const pulleyVolume = Number(pulleyDescribed.volumeMm3);
const pulleyBounds = pulleyDescribed.bounds as { min?: number[]; max?: number[] } | undefined;
const pulleyBox = gt2Box(20, 6);
const pulleyWant = gt2Volume(20, 5, 6);
console.log(`part gt2: measured volume ${pulleyVolume} mm3, analytic ${pulleyWant} mm3, measured bounds ${show(pulleyBounds)}, analytic bounds ${show(pulleyBox)}`);
check("solid_new gt2", pulley.ok === true, show(pulley));
check("gt2 volume within 0.5 mm3", Math.abs(pulleyVolume - pulleyWant) < 0.5, show(pulleyDescribed));
check("gt2 bounds within 0.02 mm", nearBox(pulleyBounds, pulleyBox), show(pulleyBounds));
const pulleyChecked = await call("model_check", { object: pulleyObject });
check("gt2 is closed", JSON.stringify(pulleyChecked.edges) === JSON.stringify({ open: 0, nonManifold: 0 }), show(pulleyChecked.edges));

function vPulleyVolume(bw: number, c: number, h: number, e: number, f: number, ddBreak: number, dd: number, grooves: number, bore: number): number {
  const alpha = dd <= ddBreak ? 34 : 38;
  const t = Math.tan(((alpha / 2) * Math.PI) / 180);
  const rd = dd / 2;
  const re = rd + c;
  const rb = rd - h;
  const w = 2 * f + (grooves - 1) * e;
  const vg = 2 * Math.PI * (0.5 * (bw - 2 * rd * t) * (re * re - rb * rb) + (2 * t / 3) * (re ** 3 - rb ** 3));
  return Math.PI * re * re * w - grooves * vg - Math.PI * (bore / 2) ** 2 * w;
}

const vPulley = await call("solid_new", { primitive: "part", kind: "v", name: "v-spz" });
const vObject = String(vPulley.object ?? "");
const vDescribed = vObject ? await call("model_describe", { object: vObject, limit: 0 }) : {};
const vVolume = Number(vDescribed.volumeMm3);
const vBounds = vDescribed.bounds as { min?: number[]; max?: number[] } | undefined;
const vWant = vPulleyVolume(8.5, 2.0, 9.0, 12.0, 8.0, 80, 63, 1, 8);
const vBox: [[number, number, number], [number, number, number]] = [[-33.5, -33.5, 0], [33.5, 33.5, 16]];
console.log(`part v SPZ 63: measured volume ${vVolume} mm3, analytic ${vWant} mm3, measured bounds ${show(vBounds)}, analytic bounds ${show(vBox)}`);
check("solid_new v default SPZ 63", vPulley.ok === true, show(vPulley));
check("v SPZ 63 volume within 0.5 mm3", Math.abs(vVolume - vWant) < 0.5, show(vDescribed));
check("v SPZ 63 bounds within 0.02 mm", nearBox(vBounds, vBox), show(vBounds));
const vChecked = await call("model_check", { object: vObject });
check("v SPZ 63 is closed", JSON.stringify(vChecked.edges) === JSON.stringify({ open: 0, nonManifold: 0 }), show(vChecked.edges));

const vSpb = await call("solid_new", { primitive: "part", kind: "v", section: "SPB", diameter: 200, grooves: 3, bore: 25, name: "v-spb" });
const vSpbObj = String(vSpb.object ?? "");
const vSpbDesc = vSpbObj ? await call("model_describe", { object: vSpbObj, limit: 0 }) : {};
const vSpbWant = vPulleyVolume(14.0, 3.5, 14.0, 19.0, 12.5, 190, 200, 3, 25);
check("solid_new v SPB 200 3 grooves", vSpb.ok === true && Math.abs(Number(vSpbDesc.volumeMm3) - vSpbWant) < 0.5, show(vSpbDesc));

let vBadErr = "";
try {
  await call("solid_new", { primitive: "part", kind: "v", section: "A" });
} catch (err) {
  vBadErr = err instanceof Error ? err.message : String(err);
}
check("unknown V pulley section is refused by schema", vBadErr.includes("SPZ") && vBadErr.includes("SPC"), vBadErr);
const vBadBore = await call("solid_new", { primitive: "part", kind: "v", section: "SPZ", diameter: 63, bore: 42 });
check("oversize V pulley bore is refused", vBadBore.ok === false && String(vBadBore.reason ?? "").includes("under the grooves"), show(vBadBore));

if (failed > 0) {
  console.error(`part: ${failed} failed`);
  process.exit(1);
}
console.log("part: ok");
process.exit(0);
