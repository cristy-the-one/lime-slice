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
// Flat faces keep the mesh pass's answer (6.8.0 changes nothing there): no margin, no second answer, two kernel checks.
check("flat faces: the mesh pass placed it, with no chord margin", flat.contact?.check === "mesh" && flat.contact?.boundMm === 0 && flat.mesh === undefined && flat.exact?.placed === "mesh", flat);
check("flat faces: two kernel checks, at the answer and just past it", flat.exact?.kernelCalls === 2 && flat.exact?.backedOff?.degrees === 0, flat.exact);
console.log(`     flat: ${flat.angle} deg (by hand ${expected.toFixed(6)}), exact ${JSON.stringify(flat.exact)}`);
await call("plate_undo");

/** The kernel's verdict on the wheel's tooth and `other` where they stand (model_check {interference, exact}). */
type Pair = { a: string; b: string; verdict: string; volumeMm3?: number };
const kernelSays = async (other: string): Promise<Pair | undefined> => {
  const reply = await call("model_check", { object: tooth, interference: true, exact: true });
  return ((reply.pairs as Pair[] | undefined) ?? []).find((row) => [row.a, row.b].includes(tooth) && [row.a, row.b].includes(other));
};
const clearOrTouch = (pair: Pair | undefined) => !pair || pair.verdict !== "crossing";

// A round pin: its mesh is facets within the chord (0.05 mm) inside the true cylinder, so the facets meet late. Before
// 6.8.0 the pose was the facets' contact (71.283465 deg in CI), where the kernel found 0.011 mm³ shared (0.022 mm³ just
// past it). Now the kernel decides: it backs off from the facets' contact to a pose it calls clear or a touch.
await call("object_remove", { object: pallet });
const pin = await solid({ primitive: "cylinder", radius: 3, height: 5, name: "Pin" });
await place({ object: pin, to: frame, x: 0, y: 14, z: 6 });

// Without the kernel, the mesh pass keeps the pin's chord: short of the facets' contact, and the kernel calls it clear.
const margin = await call("model_place", { object: hub, until: { contact: pin, dir: 1, exact: false } });
check("exact false: the wheel stops on the round pin", margin.ok === true && margin.contact?.other === pin && margin.exact === undefined, margin);
check("exact false: the bound is the pin's chord, and it stopped short of the facets' contact", Math.abs(Number(margin.contact?.boundMm) - 0.05) < 1e-6 && typeof margin.mesh?.angle === "number" && margin.angle < margin.mesh.angle, margin);
check("exact false: the note says the true parts cannot overlap", /cannot overlap/.test(String(margin.note)), margin.note);
const marginPair = await kernelSays(pin);
check("exact false: the kernel calls the margin's pose clear or a touch", clearOrTouch(marginPair), marginPair);
console.log(`     round pin, mesh pass with the chord margin: ${margin.angle} deg (facets meet at ${margin.mesh?.angle}), kernel ${JSON.stringify(marginPair ?? "clear")}`);
await call("plate_undo");

const round = await call("model_place", { object: hub, until: { contact: pin, dir: 1 } });
check("the wheel stops on the round pin", round.ok === true && round.contact?.other === pin, round);
check("exact says whether the facets' contact agrees, with the volume, and the note says so", typeof round.exact?.agrees === "boolean" && typeof round.exact.meshAnswer?.volumeMm3 === "number" && /kernel/.test(String(round.note)), round);
check("the pose is the kernel's: clear or a touch there", round.exact?.placed === "kernel" && round.contact?.check === "kernel" && round.exact.atContact?.verdict !== undefined && round.exact.atContact.verdict !== "crossing", round.exact);
const facets = typeof round.mesh?.angle === "number" ? round.mesh.angle : round.angle;
check("never past the facets' contact", round.angle <= facets + 1e-9, { angle: round.angle, facets });
check("the reply says how far it backed off from the facets' contact", typeof round.exact?.backedOff?.degrees === "number" && Math.abs(round.exact.backedOff.degrees - (facets - round.angle)) < 2e-6 && typeof round.exact.backedOff.travelMm === "number", round.exact);
if (round.exact?.agrees === false) check("where the kernel found shared volume at the facets' contact, the note says it backed off", round.exact.backedOff.degrees > 0 && /backed off/.test(String(round.note)), round.note);
check("within the budget of kernel checks, and the cost is said", round.exact?.kernelCalls <= round.exact?.budget + 1 && typeof round.exact?.kernelMs === "number", round.exact);
const roundPair = await kernelSays(pin);
check("model_check {interference, exact} agrees: the wheel and the pin do not cross where it stopped", clearOrTouch(roundPair), roundPair);
console.log(`     round pin: ${round.angle} deg (facets meet at ${facets}), exact ${JSON.stringify(round.exact)}, kernel now ${JSON.stringify(roundPair ?? "clear")}`);
console.log(`     note: ${String(round.note)}`);

if (failed) {
  console.error(`contact-occt: ${failed} failed`);
  process.exit(1);
}
console.log("contact-occt: ok");
process.exit(0);
