/**
 * Writes the project `e2e/pose-gears.spec.ts` opens: a frame, a 12-tooth pinion and a 24-tooth wheel at their centre
 * distance with the mating phase, each on a hinge about its axis, not yet coupled. Built by the MCP session on the fake
 * engine, so the gears are Model tree roots exactly as the app saves them. Run with Node:
 * `node --experimental-strip-types --no-warnings e2e/gear-train-project.ts <out.lime>`.
 */
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeEngine } from "../mcp/engine.ts";
import { Session } from "../mcp/session.ts";

const out = process.argv[2];
if (!out) throw new Error("Give the .lime path to write.");
process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-pose-gears-"));
const session = new Session(fakeEngine());
const call = async (name: string, input: Record<string, unknown> = {}) => {
  const reply = (await session.call(name, input)) as Record<string, unknown>;
  if (reply.ok !== true) throw new Error(`${name}: ${JSON.stringify(reply)}`);
  return reply;
};
const frame = String((await call("solid_new", { primitive: "box", dx: 90, dy: 50, dz: 4, name: "frame" })).object);
const pinion = String((await call("solid_new", { gear: { teeth: 12, module: 2, thickness: 6, bore: 5 }, name: "pinion" })).object);
const wheel = String((await call("solid_new", { gear: { teeth: 24, module: 2, thickness: 6, bore: 5, phaseDeg: 172.5 }, name: "wheel" })).object);
for (const [object, x] of [[pinion, 0], [wheel, 36]] as const) {
  await call("model_place", { object, to: frame, x, y: 0, z: 4 });
  await call("model_place", { object, joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1] } });
}
const saved = await call("project_save", { name: "pose-gears.lime" });
copyFileSync(String(saved.path), out);
console.log(JSON.stringify({ frame, pinion, wheel }));
process.exit(0);
