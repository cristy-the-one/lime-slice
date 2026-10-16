/**
 * Paint disks, support edits, layer files, calibration, and blend points.
 * The hand-brush count is proved in src/paint-region.test.ts against the real ledge mesh.
 * This file checks the tools store those disks and send them with the slice.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-batch3-"));
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

const engine = fakeEngine();
const session = new Session(engine);
const call = (name: string, args: unknown = {}) => session.call(name, args);

const ledge = new URL("../samples/overhang_ledge.stl", import.meta.url);
const imported = await call("mesh_import", { path: fileURLToPath(ledge) });
check("the ledge imports", imported.ok === true, JSON.stringify(imported));

const miss = await call("paint_supports", { region: { box: { min: [500, 500, 500], max: [510, 510, 510] } } });
check("a box that misses the part is refused", miss.ok === false && miss.reason === "No surface is inside that box.", JSON.stringify(miss));

const dry = await call("paint_supports", { region: { overhangBelowDeg: 50 }, radiusMm: 3, dryRun: true });
const before = await call("paint_list", {});
check("a dry run names the disks and writes nothing", dry.ok === true && dry.dryRun === true && (dry.disks as number) > 0 && before.total === 0, JSON.stringify({ dry, before }));

const painted = await call("paint_supports", { region: { overhangBelowDeg: 50 }, radiusMm: 3 });
const warnings = painted.warnings as string[] | undefined;
check(
  "overhang paint is kept and supports-off is named",
  painted.ok === true && (painted.disks as number) > 0 && warnings?.[0] === "Paint is kept but not used while supports are off.",
  JSON.stringify(painted),
);
const after = await call("paint_list", {});
check("paint_list counts those disks", after.total === painted.disks, JSON.stringify(after));

await call("settings_set", { values: { supports: true } });
const seam = await call("paint_seam", { region: { overhangBelowDeg: 50 }, radiusMm: 5 });
check("seam paint uses the same overhang", seam.ok === true && (seam.disks as number) > 0, JSON.stringify(seam));
const far = await call("reinforce_add", { kind: "box", centre: [0, 0, 0], sizeMm: [2, 2, 2], frame: "part" });
const near = await call("reinforce_add", { kind: "box", centre: [25, 6, 4], sizeMm: [4, 4, 4], frame: "part" });
check("a volume off the part is refused and one on it is kept", far.ok === false && far.reason === "That volume does not touch the part." && near.ok === true, JSON.stringify({ far, near }));

await call("machine_select", { printerId: "lime-220", filamentId: "lime-pla" });
const started = await call("slice_start", { scope: "object" });
await call("slice_wait", { job: started.job });
const body = JSON.parse(engine.lastSlice) as { supportPaint?: unknown[]; seamPaint?: unknown[] };
check("the slice sends the support disks and the seam disks", (body.supportPaint?.length ?? 0) === painted.disks && (body.seamPaint?.length ?? 0) === seam.disks, JSON.stringify({ support: body.supportPaint?.length, seam: body.seamPaint?.length }));

const trees = await call("support_trees", {});
check("the slice lists a support tree", trees.ok === true && (trees.total as number) >= 1, JSON.stringify(trees));
const prune = await call("support_edit", { action: "prune", site: { xy: [20, 0], zMm: 8 }, scope: "tree" });
check("a prune names the sites", prune.ok === true && (prune.sites as number) >= 1, JSON.stringify(prune));
const regrow = await call("support_edit", { action: "regrow", site: { xy: [20, 0], zMm: 6 } });
check("a regrow uses the unheld patch", regrow.ok === true && regrow.action === "regrow", JSON.stringify(regrow));
const edited = await call("slice_start", { scope: "object" });
await call("slice_wait", { job: edited.job });
const editedBody = JSON.parse(engine.lastSlice) as { supportEdits?: { kind?: string }[]; reinforcement?: { kind?: string }[] };
check("the next slice sends the prune and the regrow", editedBody.supportEdits?.some((row) => row.kind === "prune") === true && editedBody.supportEdits?.some((row) => row.kind === "regrow") === true, JSON.stringify(editedBody.supportEdits));
check("the slice sends the reinforcement volume", editedBody.reinforcement?.some((row) => row.kind === "box") === true, JSON.stringify(editedBody.reinforcement));

const svg = await call("layer_paths", { layer: 0 });
const svgText = svg.ok === true ? readFileSync(String(svg.path), "utf8") : "";
check("layer 0 svg has the skirt and the 20 mm square", svgText.includes("data-kind=\"skirt\"") && svgText.includes("data-kind=\"outer\"") && svgText.includes("20,20"), svgText.slice(0, 240));
const png = await call("layer_image", { layer: 0, colourBy: "feature" });
const pngBytes = png.ok === true ? readFileSync(String(png.path)) : Buffer.alloc(0);
check("layer 0 png decodes", pngBytes[0] === 137 && pngBytes[1] === 80 && pngBytes[2] === 78 && pngBytes[3] === 71, JSON.stringify(png));
const detail = await call("layer_detail", { layers: [0, 1] });
const rows = detail.rows as { z?: number; seconds?: number }[];
check("layer detail names both layers", detail.ok === true && rows.length === 2 && rows[0]?.z === 0.2 && rows[1]?.seconds === 6, JSON.stringify(detail));

await call("layer_action_set", { zMm: 0.15, kind: "filamentChange" });
const marked = await call("slice_start", { scope: "object" });
await call("slice_wait", { job: marked.job });
const found = await call("gcode_read", { grep: "M600" });
const lines = found.lines as { text?: string }[];
check("gcode_read finds the filament change", found.ok === true && lines.some((line) => line.text === "M600"), JSON.stringify(found));

const many = await call("calibration_tower", { kind: "pa", start: 0, end: 0.5, step: 0.01 });
check("more than 40 bands is refused", many.ok === false && String(many.reason).includes("40"), JSON.stringify(many));
const tall = await call("calibration_tower", { kind: "flow", start: 0.9, end: 1.1, step: 0.1, bandHeightMm: 100 });
check("a tower taller than the bed is refused", tall.ok === false && String(tall.reason).includes("bed"), JSON.stringify(tall));
const tower = await call("calibration_tower", { kind: "pa", start: 0, end: 0.04, step: 0.01 });
const bands = tower.bands as { value?: number }[];
check("a PA tower writes its bands", tower.ok === true && bands.length === 5 && bands[0]?.value === 0 && readFileSync(String(tower.gcodePath), "utf8").includes("calibration"), JSON.stringify(tower));
const saved = await call("calibration_apply", { kind: "pa", value: 0.04 });
const machine = await call("machine_get", {});
const advance = (machine.filament as { pressureAdvance?: Record<string, number> } | undefined)?.pressureAdvance ?? {};
check("the filament keeps the pressure advance", saved.ok === true && Object.values(advance).includes(0.04), JSON.stringify({ saved, advance }));

const blends = await call("blend_compare", {});
const points = blends.points as { toughness?: number }[];
const applied = await call("blend_apply", { index: 0 });
const blended = await call("slice_start", { scope: "object" });
await call("slice_wait", { job: blended.job });
const blend = (JSON.parse(engine.lastSlice) as { blend?: { mode?: string; strategy?: string } }).blend;
check("blend_compare returns points and the first one is speed", blends.ok === true && points.length >= 3 && applied.ok === true && blend?.mode === "single" && blend.strategy === "speed", JSON.stringify({ blends, applied, blend }));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("batch3: ok");
