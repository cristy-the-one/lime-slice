/**
 * Assemblies M7 (docs/plan-assemblies.md, section 6 and D11), through the MCP server against real Open CASCADE:
 * model_check {interference, exact} measures each pair's common volume. A pin that fits its hole shares no volume; one
 * too wide shares the ring it overlaps; one wider by a sliver reads as a touch. Skips when LIME_OCCT_BRIDGE is unset,
 * and fails in CI when it is unset.
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
    console.error("interference-exact: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("interference-exact: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-interference-"));
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

type Pair = { a: string; b: string; verdict: string; exact?: boolean; volumeMm3?: number; overlapMm?: { min: number[]; max: number[] }; nested?: boolean; note?: string };
const session = new Session(loadEngineWorker(root));
const call = async (name: string, args: unknown = {}) => (await session.call(name, args)) as Record<string, any>;

await call("project_create", {});
const body = String((await call("solid_new", { primitive: "box", dx: 40, dy: 40, dz: 10 })).object);
const hole = { kind: "boolean", op: "cut", primitive: "cylinder", radius: 3, height: 20, centre: [0, 0, 5] };
await call("model_probe", { object: body, op: hole });
const cut = await call("model_apply", { object: body, op: hole });
check("a 6 mm hole goes through the body", cut.ok === true, JSON.stringify(cut));

/** A pin of `radius` standing in the hole, in the body's assembly, and the exact check's pair for it. */
async function pinIn(radius: number): Promise<{ pin: string; pair: Pair | undefined; cheap: Pair | undefined; reply: Record<string, any> }> {
  const pin = String((await call("solid_new", { primitive: "cylinder", radius, height: 10 })).object);
  const placed = await call("model_place", { object: pin, to: body, x: 0, y: 0, z: 0 });
  if (placed.ok !== true) throw new Error(JSON.stringify(placed));
  const mesh = await call("model_check", { object: pin, interference: true });
  const reply = await call("model_check", { object: pin, interference: true, exact: true });
  const find = (rows: Pair[]) => rows.find((row) => [row.a, row.b].includes(pin) && [row.a, row.b].includes(body));
  await call("object_remove", { object: pin });
  return { pin, pair: find(reply.pairs ?? []), cheap: find(mesh.pairs ?? []), reply };
}

const fits = await pinIn(2.9);
check("a 5.8 mm pin in the 6 mm hole is measured", fits.reply.ok === true && fits.reply.pass === "exact", JSON.stringify(fits.reply));
check("and shares no volume", fits.pair?.exact === true && fits.pair.volumeMm3 === 0 && fits.pair.verdict === "touch", JSON.stringify(fits.pair));

const wide = await pinIn(3.5);
const ring = Math.PI * (3.5 ** 2 - 3 ** 2) * 10;
check("a 7 mm pin crosses the body by the mesh", wide.cheap?.verdict === "crossing", JSON.stringify(wide.cheap));
check(`and shares the ring it overlaps, about ${ring.toFixed(1)} mm³`, wide.pair?.verdict === "crossing" && Math.abs((wide.pair.volumeMm3 ?? 0) - ring) < ring * 0.02, JSON.stringify(wide.pair));
check("the overlap's box is the ring's", !!wide.pair?.overlapMm && Math.abs(wide.pair.overlapMm.max[0]! - 3.5) < 0.05 && Math.abs(wide.pair.overlapMm.max[2]! - 10) < 0.05, JSON.stringify(wide.pair?.overlapMm));
check("the note says a pair shares volume and nothing is blocked", String(wide.reply.note).includes("share volume") && String(wide.reply.note).includes("Nothing is blocked"), String(wide.reply.note));

// D11: wider by 0.00004 mm, the ring is about 0.0075 mm³, under 0.01 mm³: a touch, however the meshes cross.
const sliver = await pinIn(3.00004);
check("a sliver of common volume reads as a touch", sliver.pair?.exact === true && sliver.pair.verdict === "touch" && (sliver.pair.volumeMm3 ?? 1) < 0.01, JSON.stringify({ cheap: sliver.cheap, exact: sliver.pair }));

// A mesh part is not measured, and says so.
const mesh = String((await call("solid_new", { primitive: "box", dx: 4, dy: 4, dz: 4 })).object);
await call("model_place", { object: mesh, to: body, x: 15, y: 15, z: 8 });
const touching = await call("model_check", { object: body, interference: true, exact: true });
const meshPair = (touching.pairs as Pair[]).find((row) => [row.a, row.b].includes(mesh));
check("a box sunk 2 mm into the body is measured at 32 mm³", meshPair?.verdict === "crossing" && Math.abs((meshPair.volumeMm3 ?? 0) - 32) < 0.1, JSON.stringify(meshPair));

if (failed > 0) {
  console.error(`interference-exact: ${failed} failed`);
  process.exit(1);
}
console.log("interference-exact: ok");
process.exit(0);
