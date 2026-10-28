/**
 * A STEP file of several named solids through the MCP server against real Open CASCADE: mesh_import opens it as its
 * pieces when asked, says how many solids it holds when not, and object_split_shells splits the one object by its
 * solids, while an STL still splits by shells.
 * Skips when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
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
    console.error("step-solids: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("step-solids: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-step-solids-"));
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

const session = new Session(loadEngineWorker(root));
const call = (name: string, args: unknown = {}) => session.call(name, args);
type Row = { object: string; name: string; bboxMm: { min: number[]; max: number[] } };
const plate = async () => ((await call("plate_list", { limit: 100 })).objects as Row[]);
const clear = async () => {
  for (const row of await plate()) await call("object_remove", { object: row.object });
};
const near = (a: number, b: number, tol = 0.05) => Math.abs(a - b) <= tol;

// A 400 mm tall box cut in three for the Form 4 and exported as One STEP: three named solids, placed as cut.
const tall = String((await call("solid_new", { primitive: "box", dx: 100, dy: 80, dz: 400 })).object);
const plan = await call("model_probe", { object: tall, op: { kind: "partition", target: { printer: "formlabs-form-4" } }, plan: true });
const op = { ...(plan.op as Record<string, unknown>), labels: { on: false } };
await call("model_probe", { object: tall, op });
const applied = await call("model_apply", { object: tall, op });
const exported = await call("model_export_step", { object: tall, name: "trio", pieces: true });
check("the box exports as one STEP of three solids", applied.ok === true && exported.ok === true && exported.solids === 3, JSON.stringify({ applied, exported }));
const names = ["trio-1", "trio-2", "trio-3"];
const step = String(exported.path);
await clear();

const pieces = await call("mesh_import", { path: step, pieces: true });
const opened = await plate();
check("mesh_import with pieces opens three objects", pieces.ok === true && (pieces.objects as string[]).length === 3 && opened.length === 3, JSON.stringify(pieces));
check("the objects carry the STEP's names, in order", JSON.stringify(opened.map((row) => row.name)) === JSON.stringify(names), JSON.stringify(opened.map((row) => row.name)));
const zs = opened.map((row) => [row.bboxMm.min[2]!, row.bboxMm.max[2]!]).sort((a, b) => a[0]! - b[0]!);
check(
  "the pieces stand as assembled: stacked, each where the cut left it",
  near(zs[0]![0]!, 0) && near(zs[2]![1]!, 400) && near(zs[0]![1]!, zs[1]![0]!) && near(zs[1]![1]!, zs[2]![0]!),
  JSON.stringify(zs),
);
check("the solids form one assembly named for the file", pieces.assembly === "trio" && opened.every((row) => (row as { assembly?: string }).assembly === "trio"), JSON.stringify({ assembly: pieces.assembly, rows: opened.map((row) => (row as { assembly?: string }).assembly) }));
const described = await call("model_describe", { object: opened[1]!.object, limit: 1 });
check("a piece opens in Model as a solid", described.ok === true && typeof described.volumeMm3 === "number" && (described.volumeMm3 as number) > 100 * 80 * 100, JSON.stringify(described).slice(0, 400));
await clear();

const whole = await call("mesh_import", { path: step });
check(
  "mesh_import without pieces opens one object and says how to ask for them",
  whole.ok === true && whole.solids === 3 && String(whole.note).includes("pieces: true") && (await plate()).length === 1,
  JSON.stringify(whole),
);
const split = await call("object_split_shells", { object: String(whole.object) });
const after = await plate();
check("object_split_shells splits the one object by its three solids", split.ok === true && split.solids === 3 && after.length === 3, JSON.stringify(split));
check("the split pieces carry the STEP's names", JSON.stringify(after.map((row) => row.name)) === JSON.stringify(names), JSON.stringify(after.map((row) => row.name)));
const undone = await call("plate_undo", {});
check("undo puts the one object back", undone.ok === true && (await plate()).length === 1, JSON.stringify(undone));
await clear();

// Two boxes 30 mm apart in one STL: still split by shells.
const face = (a: number[], b: number[], c: number[], d: number[]) => [...a, ...b, ...c, ...a, ...c, ...d];
const box = (x0: number, x1: number) => {
  const p = (x: number, y: number, z: number) => [x, y, z];
  return [
    ...face(p(x0, 0, 0), p(x1, 0, 0), p(x1, 10, 0), p(x0, 10, 0)),
    ...face(p(x0, 0, 10), p(x0, 10, 10), p(x1, 10, 10), p(x1, 0, 10)),
    ...face(p(x0, 0, 0), p(x0, 0, 10), p(x1, 0, 10), p(x1, 0, 0)),
    ...face(p(x1, 10, 0), p(x1, 10, 10), p(x0, 10, 10), p(x0, 10, 0)),
    ...face(p(x0, 0, 0), p(x0, 10, 0), p(x0, 10, 10), p(x0, 0, 10)),
    ...face(p(x1, 0, 0), p(x1, 0, 10), p(x1, 10, 10), p(x1, 10, 0)),
  ];
};
const pair = join(workspace, "pair.stl");
writeFileSync(pair, stlBytes(new Float32Array([...box(0, 10), ...box(40, 50)]), "pair.stl"));
const stl = await call("mesh_import", { path: pair, pieces: true });
check("an STL ignores pieces and opens as one object", stl.ok === true && typeof stl.object === "string" && stl.solids === undefined, JSON.stringify(stl));
const shells = await call("object_split_shells", { object: String(stl.object) });
check("an STL still splits by shells", shells.ok === true && shells.shells === 2 && shells.label === "Separate shells", JSON.stringify(shells));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("step-solids: ok");
process.exit(0);
