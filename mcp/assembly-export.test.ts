/**
 * Assemblies M9 (docs/plan-assemblies.md), through the MCP server against real Open CASCADE: model_export_step
 * {assembly: true} writes a body, a hook and a clip as one STEP of named solids at their assembled poses, and
 * mesh_import {pieces: true} reads it back as three named solids standing where the assembly put them. Skips when
 * LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { stlBytes } from "./request.ts";
import { Session } from "./session.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("assembly-export: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("assembly-export: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-assembly-export-"));
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

type Box = { min: number[]; max: number[] };
type Row = { object: string; name: string; bboxMm: Box; assembledMm?: Box; assembly?: string };
const session = new Session(loadEngineWorker(root));
const call = async (name: string, args: unknown = {}) => (await session.call(name, args)) as Record<string, any>;
const plate = async () => ((await call("plate_list", { limit: 100 })).objects as Row[]);
const sameBox = (a: Box | undefined, b: Box | undefined, tol = 0.02) =>
  !!a && !!b && [...a.min, ...a.max].every((value, i) => Math.abs(value - [...b.min, ...b.max][i]!) <= tol);
const show = (value: unknown) => JSON.stringify(value);

await call("project_create", {});
const body = String((await call("solid_new", { primitive: "box", dx: 40, dy: 30, dz: 10 })).object);
const hook = String((await call("solid_new", { primitive: "box", dx: 6, dy: 4, dz: 12 })).object);
const clip = String((await call("solid_new", { primitive: "box", dx: 8, dy: 8, dz: 2 })).object);
const free = String((await call("solid_new", { primitive: "cylinder", radius: 3, height: 5 })).object);

const hooked = await call("model_place", { object: hook, to: body, x: 15, y: 5, z: 10, turnZ: 90, assembly: "LED cover" });
const clipped = await call("model_place", { object: clip, to: hook, x: 0, y: 0, z: 12, turnX: 90 });
const moved = await call("model_place", { object: body, x: 5, y: -2, z: 0 });
check("a hook on the body and a clip on the hook form one assembly, and the root moves it", hooked.ok === true && clipped.ok === true && moved.ok === true, show({ hooked, clipped, moved }));

const before = await plate();
const bedBefore = before.map((row) => row.bboxMm);
const exported = await call("model_export_step", { object: clip, name: "cover", assembly: true });
check("model_export_step {assembly} writes one STEP of three solids", exported.ok === true && exported.solids === 3 && exported.assembly === "LED cover", show(exported));
const parts = (exported.parts ?? []) as { object: string; name: string; volumeMm3: number; assembledMm: Box }[];
check("the root comes first, then its members in order", show(parts.map((row) => row.object)) === show([body, hook, clip]), show(parts));
const names = parts.map((row) => row.name);
check("each solid is named after its part, and no two names are the same", names.length === 3 && new Set(names.map((name) => name.toLowerCase())).size === 3 && names.every((name) => name.length > 0), show(names));
for (const part of parts) {
  const listed = before.find((row) => row.object === part.object);
  check(`${part.name}'s box in the reply is its assembled box`, sameBox(part.assembledMm, listed?.assembledMm), show({ part, listed }));
}
check("the export moves nothing on the bed", show((await plate()).map((row) => row.bboxMm)) === show(bedBefore));

const pieces = await call("mesh_import", { path: String(exported.path), pieces: true });
const back = (await plate()).filter((row) => !before.some((old) => old.object === row.object));
check("the file reads back through the multi-solid reader as three solids", pieces.ok === true && back.length === 3, show({ pieces, back }));
check("with the part names, in the same order", show(back.map((row) => row.name)) === show(names), show(back.map((row) => row.name)));
const volumes = [40 * 30 * 10, 6 * 4 * 12, 8 * 8 * 2];
for (const [index, row] of back.entries()) {
  const described = await call("model_describe", { object: row.object, limit: 1 });
  check(`${row.name} keeps its volume, ${volumes[index]} mm³`, Math.abs(Number(described.volumeMm3) - volumes[index]!) < 0.01, show(described.volumeMm3));
  check(`${row.name} stands at its assembled pose`, sameBox(row.assembledMm, parts[index]?.assembledMm), show({ read: row.assembledMm, exported: parts[index]?.assembledMm }));
}
const hookBox = parts[1]!.assembledMm;
check("the hook's quarter turn reached the file: its 6 mm side lies along Y", Math.abs(hookBox.max[1]! - hookBox.min[1]! - 6) < 0.02 && Math.abs(hookBox.max[0]! - hookBox.min[0]! - 4) < 0.02, show(hookBox));
const clipBox = parts[2]!.assembledMm;
check("the clip stands on its edge on top of the hook", Math.abs(clipBox.max[2]! - clipBox.min[2]! - 8) < 0.02 && clipBox.min[2]! >= hookBox.max[2]! - 4.01, show({ clipBox, hookBox }));

const refused = await call("model_export_step", { object: free, name: "loose", assembly: true });
check("a part in no assembly is refused, with the way in", refused.ok === false && String(refused.reason).includes("model_place {to}"), show(refused));
const both = await call("model_export_step", { object: body, name: "both", assembly: true, pieces: true });
check("pieces and assembly together are refused", both.ok === false && String(both.reason).includes("not both"), show(both));

const face = (a: number[], b: number[], c: number[], d: number[]) => [...a, ...b, ...c, ...a, ...c, ...d];
const p = (x: number, y: number, z: number) => [x, y, z];
const cube = [
  ...face(p(0, 0, 0), p(10, 0, 0), p(10, 10, 0), p(0, 10, 0)),
  ...face(p(0, 0, 10), p(0, 10, 10), p(10, 10, 10), p(10, 0, 10)),
  ...face(p(0, 0, 0), p(0, 0, 10), p(10, 0, 10), p(10, 0, 0)),
  ...face(p(10, 10, 0), p(10, 10, 10), p(0, 10, 10), p(0, 10, 0)),
  ...face(p(0, 0, 0), p(0, 10, 0), p(0, 10, 10), p(0, 0, 10)),
  ...face(p(10, 0, 0), p(10, 0, 10), p(10, 10, 10), p(10, 10, 0)),
];
const stlPath = join(workspace, "cap.stl");
writeFileSync(stlPath, stlBytes(new Float32Array(cube), "cap.stl"));
const cap = String((await call("mesh_import", { path: stlPath })).object);
const capped = await call("model_place", { object: cap, to: body, x: 0, y: 0, z: 10 });
const meshy = await call("model_export_step", { object: body, name: "meshy", assembly: true });
check("a mesh member is refused by name: a STEP assembly holds solids only", capped.ok === true && meshy.ok === false && String(meshy.reason).includes("solids only") && String(meshy.reason).startsWith("cap"), show({ capped, meshy }));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("assembly-export: ok");
process.exit(0);
