/**
 * Contact in poses against real Open CASCADE (docs/plan-contact-poses.md section 2): model_place {until} with exact
 * stops a wheel's tooth on a flat pallet, and the kernel finds no shared volume at the answer; a round pin (facets on a
 * cylinder) stops it too, and whatever the kernel says there is reported in `exact`, agreeing or not, never hidden.
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
    console.error("contact-occt: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("contact-occt: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-contact-"));
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "25";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 2000)}`);
}

// A reply is read field by field below; the shape is the server's, not this test's.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { [key: string]: any };
const session = new Session(loadEngineWorker(root));
const call = async (name: string, args: unknown = {}) => (await session.call(name, args)) as Reply;
await call("project_create", {});
const solid = async (input: Reply) => {
  const made = await call("solid_new", input);
  if (made.ok !== true) throw new Error(JSON.stringify(made));
  return String(made.object);
};
const place = async (input: Reply) => {
  const placed = await call("model_place", input);
  if (placed.ok !== true) throw new Error(JSON.stringify(placed));
};

const frame = await solid({ primitive: "box", dx: 120, dy: 120, dz: 4, name: "Frame" });
const hub = await solid({ primitive: "box", dx: 4, dy: 4, dz: 5, name: "Wheel" });
const tooth = await solid({ primitive: "box", dx: 12, dy: 3, dz: 5, name: "Tooth" });
const pallet = await solid({ primitive: "box", dx: 4, dy: 8, dz: 5, name: "Pallet" });
await place({ object: hub, to: frame, x: 0, y: 0, z: 6 });
await place({ object: hub, joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1] } });
await place({ object: tooth, to: hub, x: 10, y: 0, z: 0 });
await place({ object: pallet, to: frame, x: 0, y: 16, z: 6 });

const deg = 180 / Math.PI;
const expected = Math.atan2(12, 2) * deg - Math.asin(1.5 / Math.hypot(2, 12)) * deg;
const flat = await call("model_place", { object: hub, until: { contact: pallet, dir: 1 } });
check("the wheel stops on the flat pallet", flat.ok === true && Math.abs(flat.angle - expected) < 0.06, flat);
check("with at most the tolerance left", flat.contact?.clearanceMm <= 0.011, flat.contact);
check("the kernel was asked at the answer and past it", flat.exact?.atContact?.verdict !== undefined && flat.exact?.past !== undefined, flat.exact);
check("and on flat faces it agrees: no shared volume at the answer", flat.exact?.agrees === true && flat.exact.atContact.verdict !== "crossing", flat.exact);
console.log(`     flat: ${flat.angle} deg (by hand ${expected.toFixed(6)}), exact ${JSON.stringify(flat.exact)}`);
await call("plate_undo");

// A round pin: the mesh pass sees its facets. Whatever the kernel says at the answer is in the reply.
await call("object_remove", { object: pallet });
const pin = await solid({ primitive: "cylinder", radius: 3, height: 5, name: "Pin" });
await place({ object: pin, to: frame, x: 0, y: 14, z: 6 });
const round = await call("model_place", { object: hub, until: { contact: pin, dir: 1 } });
check("the wheel stops on the round pin", round.ok === true && round.contact?.other === pin, round);
check("exact says whether it agrees, with the volume, and the note says so", typeof round.exact?.agrees === "boolean" && typeof round.exact.atContact.volumeMm3 === "number" && /kernel/.test(String(round.note)), round);
console.log(`     round pin: ${round.angle} deg, exact ${JSON.stringify(round.exact)}`);
if (round.exact?.agrees === false) console.log("     the mesh pass and the kernel disagree on the round pin, as reported in the reply");

if (failed) {
  console.error(`contact-occt: ${failed} failed`);
  process.exit(1);
}
console.log("contact-occt: ok");
