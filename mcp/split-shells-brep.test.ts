/**
 * A committed shape of two solids, split by shells: each object's model is that shell's solid, so describe, a STEP
 * export, and a join all see that solid alone.
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
    console.error("split-shells-brep: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("split-shells-brep: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-split-shells-"));
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

const near = (actual: number, expected: number, tol = 1) => Math.abs(actual - expected) <= tol;

const session = new Session(loadEngineWorker(root));
const call = (name: string, args: unknown = {}) => session.call(name, args);

type Box = { min: number[]; max: number[] };
type Row = { object: string; assembledMm?: Box };
const plate = async () => ((await call("plate_list", { limit: 20 })).objects as Row[]);

// A 40×10×10 bar, centred on X and Y with its base on Z = 0. A slot through the middle leaves two 18×10×10 solids.
const bar = String((await call("solid_new", { primitive: "box", dx: 40, dy: 10, dz: 10, name: "bar" })).object);
const cut = await call("model_apply", {
  object: bar,
  probe: true,
  op: { kind: "boolean", op: "cut", primitive: "box", origin: [-2, -6, -1], dx: 4, dy: 12, dz: 12 },
});
const compound = await call("model_describe", { object: bar, limit: 1 });
const committed = await call("model_commit", { object: bar });
const split = await call("object_split_shells", { object: bar });
const rows = await plate();
check(
  "a cut that leaves two solids splits into two objects",
  cut.ok === true && committed.ok === true && split.ok === true && split.shells === 2 && rows.length === 2,
  JSON.stringify({ cut, committed, split, rows: rows.length, compound: compound.volumeMm3 }),
);

const meshBox = new Map(rows.map((row) => [row.object, row.assembledMm]));
const pieces: { object: string; volume: number; box: Box }[] = [];
for (const row of rows) {
  const described = await call("model_describe", { object: row.object, limit: 20 });
  const faces = (described.faces ?? []) as { bbox?: Box }[];
  const after = (await plate()).find((item) => item.object === row.object)?.assembledMm;
  const mesh = meshBox.get(row.object);
  const inside = mesh && faces.length > 0 && faces.every((face) => {
    const box = face.bbox;
    if (!box) return false;
    return box.min.every((value, axis) => value >= mesh.min[axis]! - 0.5) && box.max.every((value, axis) => value <= mesh.max[axis]! + 0.5);
  });
  const sameBox = mesh && after && mesh.min.every((value, axis) => near(value, after.min[axis]!, 0.5)) && mesh.max.every((value, axis) => near(value, after.max[axis]!, 0.5));
  const volume = Number(described.volumeMm3);
  pieces.push({ object: row.object, volume, box: mesh ?? { min: [], max: [] } });
  check(
    `${row.object} describes its own solid`,
    described.ok === true && near(volume, 1800) && inside === true && sameBox === true,
    JSON.stringify({ volume, mesh, after, faces: faces.length, described: described.ok === true ? undefined : described }),
  );
}
const sum = pieces.reduce((total, piece) => total + piece.volume, 0);
check("the two volumes are the bar minus the slot, not the whole bar twice", near(sum, 3600) && near(Number(compound.volumeMm3), 3600), JSON.stringify({ sum, compound: compound.volumeMm3, pieces }));

const left = pieces.find((piece) => (piece.box.min[0] ?? 99) < -10);
const exported = left ? await call("model_export_step", { object: left.object, name: "left" }) : { ok: false };
const imported = exported.ok === true ? await call("mesh_import", { path: String(exported.path) }) : { ok: false };
const importedVolume = imported.ok === true ? await call("model_describe", { object: String(imported.object), limit: 1 }) : { volumeMm3: null };
check(
  "a STEP export of one piece is that solid alone",
  exported.ok === true && imported.ok === true && imported.solids === undefined && near(Number(importedVolume.volumeMm3), left?.volume ?? -1),
  JSON.stringify({ exported, imported, importedVolume: importedVolume.volumeMm3 }),
);

const target = await call("solid_new", { primitive: "box", dx: 10, dy: 10, dz: 10, name: "target" });
const joined = left
  ? await call("model_apply", { object: String(target.object), probe: true, op: { kind: "join", op: "fuse", toolObject: left.object, keepTool: true } })
  : { ok: false };
const fused = joined.ok === true ? await call("model_describe", { object: String(target.object), limit: 1 }) : { volumeMm3: null };
// The target is the 10 mm box on the origin (x −5..5). It overlaps the left solid (x −20..−2) in a 3×10×10 box.
check(
  "a join uses only the piece's solid",
  joined.ok === true && near(Number(fused.volumeMm3), 2500, 2),
  JSON.stringify({ joined, volume: fused.volumeMm3 }),
);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("split-shells-brep: ok");
process.exit(0);
