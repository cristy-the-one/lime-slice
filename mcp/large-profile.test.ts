/** Long point profiles and line-segment loops through the real Open CASCADE bridge. */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { validateTool } from "./schema.ts";
import { Session } from "./session.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
if (!process.env.LIME_OCCT_BRIDGE || !existsSync(process.env.LIME_OCCT_BRIDGE) || !engineCandidates(root).some(existsSync)) {
  if (process.env.CI === "true") throw new Error("large profile test needs LIME_OCCT_BRIDGE and lime-mcp-engine");
  console.log("large profile: skipped (needs native engine)");
  process.exit(0);
}
process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-large-profile-"));
const session = new Session(loadEngineWorker(root));
const points = Array.from({ length: 220 }, (_, i) => [8 * Math.cos(i * Math.PI * 2 / 220), 8 * Math.sin(i * Math.PI * 2 / 220)]);
const segments = points.map((_, i) => ({ kind: "line", to: points[(i + 1) % points.length] }));
for (const [name, shape] of [["profile", { profile: points }], ["loop", { loops: [{ start: points[0], segments }] }]] as const) {
  const made = await session.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 2 });
  const args = { object: made.object, op: { kind: "extrude", op: "fuse", origin: [0, 0, 2], depth: 1, ...shape }, probe: true };
  if (validateTool("model_apply", args) !== null) throw new Error(`${name} was rejected by the schema`);
  const result = await session.call("model_apply", args);
  if (result.ok !== true) throw new Error(`${name} failed: ${JSON.stringify(result)}`);
}
console.log("large profile: ok");
process.exit(0);
