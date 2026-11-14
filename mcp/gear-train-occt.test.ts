/**
 * A gear train with real kernel geometry (docs/plan-gear-kinds.md, stage 1), against Open CASCADE: three gears made by
 * solid_new {gear} and placed at mesh, with no frame, no hinge and no assembly. model_place {gears:"couple"} gives each a
 * hinge about its own axis and couples them; the root turns on the plate, and at every sampled turn of the train the
 * real solids share no volume by model_check {interference, exact}. Turned by hand out of phase (the coupling taken
 * off), the same solids cross: the exact check is a real judge of the poses the coupling writes. Skips when
 * LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
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
    console.error("gear-train-occt: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("gear-train-occt: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-gear-train-"));
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

// mate_phase(0, 12, 0, 24) = 172.5; mate_phase(172.5, 24, 0, 18) = 180, 42 mm on from the wheel.
const make = async (gear: Reply, name: string) => {
  const made = await call("solid_new", { gear: { module: 2, thickness: 6, bore: 5, ...gear }, name });
  if (made.ok !== true) throw new Error(show(made));
  return String(made.object);
};
const pinion = await make({ teeth: 12 }, "pinion");
const wheel = await make({ teeth: 24, phaseDeg: 172.5 }, "wheel");
const third = await make({ teeth: 18, phaseDeg: 180 }, "third");
for (const [object, x] of [[wheel, 36], [third, 78]] as const) {
  const placed = await call("model_place", { object, x, y: 0, z: 0 });
  if (placed.ok !== true) throw new Error(show(placed));
}

type Pair = { a: string; b: string; verdict: string; exact?: boolean; volumeMm3?: number };
/** The exact verdict for the pair of `a` and `b`; undefined when the boxes do not meet. */
async function exact(a: string, b: string): Promise<Pair | undefined> {
  const reply = await call("model_check", { object: a, interference: true, exact: true });
  return ((reply.pairs as Pair[] | undefined) ?? []).find((row) => [row.a, row.b].includes(a) && [row.a, row.b].includes(b));
}
const clear = (pair: Pair | undefined) => !pair || pair.verdict !== "crossing";

check("placed at mesh, the real gears share no volume", clear(await exact(pinion, wheel)) && clear(await exact(wheel, third)));

const coupled = await call("model_place", { object: pinion, gears: "couple" });
check("Couple gears gives each a hinge and makes the train", coupled.ok === true && show(coupled.hinged) === show(["pinion", "wheel", "third"]) && coupled.madeAssembly === "Gear train" && (coupled.couplings as unknown[]).length === 2 && (coupled.checked as { bad: unknown[] }).bad.length === 0, show(coupled));

// Turn the root through angles that are no whole number of teeth of any gear; at each one the exact check passes.
let bad = 0;
for (const angle of [7, 23.5, 61, 97, 154, 233]) {
  const turned = await call("model_place", { object: pinion, angle });
  if (turned.ok !== true) { bad += 1; console.error(show(turned)); continue; }
  const one = await exact(pinion, wheel), two = await exact(wheel, third);
  if (!clear(one) || !clear(two)) { bad += 1; console.error(`at ${angle}: ${show([one, two])}`); }
}
check("at six turns of the train the real solids share no volume", bad === 0);
const wheelAt = (session.objects.find((obj) => obj.id === wheel)!.modelPose.t).map((v) => Math.round(v * 1e6) / 1e6);
check("the wheel stayed on its pin", show(wheelAt) === show([36, 0, 0]), show(wheelAt));

// The judge is real: the coupling taken off, the wheel turned alone by half a tooth, the solids cross.
await call("model_place", { object: pinion, gears: "uncouple" });
const wheelAngle = (session.assemblies[0]!.members.find((row) => row.object === wheel)!.joint as { angle?: number }).angle ?? 0;
const alone = await call("model_place", { object: wheel, angle: wheelAngle + 7.5 });
const crossed = await exact(pinion, wheel);
check("turned alone by half a tooth, the real gears cross", alone.ok === true && crossed?.verdict === "crossing" && Number(crossed.volumeMm3) > 0, show(crossed));

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("gear-train-occt: a train of real gears turns without crossing");
process.exit(0);
