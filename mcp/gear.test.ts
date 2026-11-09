/**
 * The gear op (docs/plan-native-recipes.md milestone 8) through the MCP server against real Open CASCADE: solid_new
 * {gear} makes a gear, model_apply {kind:"gear"} fuses one onto a part, two gears placed at their centre distance with
 * the mating phase share no volume by model_check {interference, exact}, and turned past their backlash they cross. A
 * refusal is one sentence; guide {kind:"gear"} has the fields and an example. Skips when LIME_OCCT_BRIDGE is unset,
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
    console.error("gear: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("gear: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-gear-"));
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

// guide {kind:"gear"}: the schema, the line from tools/list, and the ops guide's lines.
const guide = await call("guide", { kind: "gear" });
const examples = (guide.examples as string[] | undefined) ?? [];
check("guide {kind:\"gear\"} has the schema and the examples", guide.ok === true && typeof guide.schema === "object" && examples.some((line) => line.includes("mate_phase")) && examples.some((line) => line.includes("solid_new {gear")), show(guide));

// A new solid that is a gear: 12 teeth of module 2, 6 thick, a 5 mm bore.
const made = await call("solid_new", { gear: { teeth: 12, module: 2, thickness: 6, bore: 5 }, name: "pinion" });
check("solid_new {gear} makes a gear", made.ok === true && typeof made.object === "string", show(made));
const pinion = String(made.object);
const pinionVolume = Number((made.fingerprint as Reply | undefined)?.volumeMm3);
// The outline's area is about the pitch circle's (r 12) less the bore: 452 - 20 = 432 mm2 for 6 mm.
check("the pinion's volume is about its pitch circle's, less the bore", pinionVolume > 6 * 400 && pinionVolume < 6 * 470, show(made));

const refused = await call("solid_new", { gear: { teeth: 5, module: 2, thickness: 6 } });
check("five teeth are refused in one sentence", refused.ok === false && String(refused.reason ?? refused.message ?? show(refused)).includes("A gear takes 6 to 150 teeth."), show(refused));
const both = await call("solid_new", { primitive: "box", gear: { teeth: 12, module: 2, thickness: 6 } });
check("a primitive and a gear together are refused", both.ok === false, show(both));

// The mate: 24 teeth at the centre distance m (z1 + z2) / 2 = 36 mm along +X, turned so its tooth 0 meets a gap.
// mate_phase(0, 12, 0, 24) = 180 - 0.5 * 360 / 24 = 172.5.
async function mate(phaseDeg: number): Promise<string> {
  const wheel = await call("solid_new", { gear: { teeth: 24, module: 2, thickness: 6, phaseDeg } });
  const object = String(wheel.object);
  const placed = await call("model_place", { object, to: pinion, x: 36, y: 0, z: 0 });
  if (placed.ok !== true) throw new Error(show(placed));
  return object;
}

type Pair = { a: string; b: string; verdict: string; exact?: boolean; volumeMm3?: number };
async function verdict(object: string): Promise<Pair | undefined> {
  const reply = await call("model_check", { object, interference: true, exact: true });
  return ((reply.pairs as Pair[] | undefined) ?? []).find((row) => [row.a, row.b].includes(object) && [row.a, row.b].includes(pinion));
}

const meshing = await mate(172.5);
const clear = await verdict(meshing);
check("two gears at their centre distance share no volume", !clear || clear.verdict !== "crossing", show(clear));
await call("object_remove", { object: meshing });

// 0.1 mm off each tooth is 0.2 mm of play at the pitch circle: turned 0.3 mm of the wheel's pitch circle, they cross.
const pastPlay = await mate(172.5 + (0.3 / 24) * (180 / Math.PI));
const crossing = await verdict(pastPlay);
check("turned past the backlash they cross", crossing?.verdict === "crossing" && crossing.exact === true && Number(crossing.volumeMm3) > 0, show(crossing));
await call("object_remove", { object: pastPlay });

// A gear fused onto a plate as one step, its history row a gear, and its teeth chamfered from that step.
const plate = String((await call("solid_new", { primitive: "box", dx: 60, dy: 60, dz: 4 })).object);
const gearOp = { kind: "gear", op: "fuse", teeth: 20, module: 1.5, thickness: 5, origin: [0, 0, 4], bore: 5, boreShape: "hex", hubDiameter: 12, hubHeight: 3, label: "wheel" };
const probed = await call("model_probe", { object: plate, op: gearOp });
check("model_probe takes a gear", probed.ok === true, show(probed));
const applied = await call("model_apply", { object: plate, op: gearOp });
check("model_apply fuses the gear", applied.ok === true, show(applied));
const history = await call("model_history", { object: plate });
check("the history row is the label", show(history).includes("\"label\":\"wheel\""), show(history));
const chamfer = { kind: "chamfer", edges: [{ fromNode: "wheel", filter: "convex" }], size: 0.2 };
const chamfered = await call("model_apply", { object: plate, op: chamfer, probe: true });
check("the gear's teeth take a chamfer from its step", chamfered.ok === true, show(chamfered));

// Five teeth fail the op's schema: the refusal names the field and the gear's fields.
const tooFew = await call("model_probe", { object: plate, op: { kind: "gear", teeth: 5, module: 1.5, thickness: 5 } }).catch((error: Error) => ({ ok: false, reason: error.message }));
check("a gear op of five teeth is refused", tooFew.ok === false && show(tooFew).includes("op.teeth must be at least 6"), show(tooFew));
// Unlabelled, the history row names the gear.
const plain = String((await call("solid_new", { primitive: "box", dx: 40, dy: 40, dz: 4 })).object);
const plainOp = { kind: "gear", teeth: 16, module: 2, thickness: 4, origin: [0, 0, 4] };
await call("model_probe", { object: plain, op: plainOp });
await call("model_apply", { object: plain, op: plainOp });
const plainHistory = await call("model_history", { object: plain });
check("the history names the gear", show(plainHistory).includes("gear 16 teeth m 2 h 4"), show(plainHistory));
const wideBore = await call("model_probe", { object: plate, op: { kind: "gear", teeth: 20, module: 1.5, thickness: 5, bore: 40 } });
check("a bore wider than the root is the engine's sentence", wideBore.ok === false && show(wideBore).includes("The bore leaves less than one module of material under the teeth"), show(wideBore));

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("gear: all passed");
process.exit(0);
