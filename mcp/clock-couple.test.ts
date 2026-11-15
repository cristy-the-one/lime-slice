/**
 * The shipped Ratchet wheel and Ratchet click over MCP (docs/plan-clock-parts.md), on the fake engine with the recipes
 * built by lust: run both by id with nothing open, put them on a frame with a hinge each at their own origin, and couple
 * the ratchet with its click giving no numbers. The reply says the teeth, tip and root were read from the wheel's stamp
 * and the free way from how the wheel was cut; turned its free way, the click lifts and drops into the next notch after
 * one tooth; turned back, it holds. A click made for other numbers is refused in one sentence. Skips without lust;
 * LIME_RECIPE_REQUIRED=1 makes that a failure.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";
import { findLust, RecipeHost, recipeCrateDir } from "./recipe.ts";
import { clickAngle } from "../src/gear-train.ts";

const lust = findLust();
if (!lust) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") {
    console.error("clock-couple: lust is required here (LIME_LUST)");
    process.exit(1);
  }
  console.log("clock-couple: skipped (set LIME_LUST to a lust build)");
  process.exit(0);
}
process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-clock-couple-ws-"));
process.env.LIME_PLUGINS_DIR = mkdtempSync(join(tmpdir(), "lime-clock-couple-lib-"));
type Reply = Record<string, unknown>;
const s = new Session(fakeEngine());
s.recipeHost = new RecipeHost({ crateDir: recipeCrateDir(import.meta.url), root: mkdtempSync(join(tmpdir(), "lime-clock-couple-host-")), lust });
const show = (value: unknown) => JSON.stringify(value);
const call = async (name: string, input: Record<string, unknown> = {}) => (await s.call(name, input)) as Reply;
const ok = async (name: string, input: Record<string, unknown>) => {
  const reply = await call(name, input);
  assert.equal(reply.ok, true, `${name} ${show(input)}: ${show(reply)}`);
  return reply;
};
const at = (id: string) => {
  const joint = s.assemblies.flatMap((row) => row.members).find((row) => row.object === id)?.joint;
  return joint?.kind === "hinge" ? joint.angle ?? 0 : undefined;
};
const near = (a: number | undefined, b: number, tol = 1e-6) => a !== undefined && Math.abs(a - b) <= tol;

// The library is empty: the shipped plugins are listed and found by id all the same.
const listed = await ok("plugin", { action: "list" });
const ids = (listed.plugins as Reply[] | undefined ?? listed.rows as Reply[] | undefined ?? []).map((row) => row.id);
assert.ok(ids.includes("clock-ratchet-wheel") && ids.includes("clock-ratchet-click"), show(listed));
const found = await ok("nugget", { action: "find", query: "ratchet click" });
assert.ok(show(found).includes('"shipped":true'), show(found));
const removed = await call("plugin", { action: "remove", id: "clock-ratchet-click" });
assert.equal(removed.ok, false, show(removed));
console.log("shipped plugins: listed with an empty library, found by nugget find, and they stay");

// Both made with nothing open, each standing where it belongs.
const wheelRun = await ok("recipe_run", { plugin: "clock-ratchet-wheel" });
const wheel = String(wheelRun.object);
const clickRun = await ok("recipe_run", { plugin: "clock-ratchet-click" });
const click = String(clickRun.object);
assert.ok(near(s.find(click)!.modelPose.t[0], 11.19) && near(s.find(click)!.modelPose.t[1], 10), `the click stands at horology's pivot: ${show(s.find(click)!.modelPose)}`);
console.log(`ratchet wheel ${wheel} and click ${click} made; the click at its pivot (11.19, 10)`);

// A frame under them; each on a hinge about +Z at its own origin, as Pose's Hinge gives it.
const frame = String((await ok("solid_new", { primitive: "box", dx: 60, dy: 60, dz: 4, name: "Frame" })).object);
await ok("model_place", { object: frame, x: 0, y: 0, z: -6 });
await ok("model_place", { objects: [wheel, click], to: frame });
const hinge = { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1] };
await ok("model_place", { object: wheel, joint: hinge });
await ok("model_place", { object: click, joint: hinge });

// A click made for other numbers is refused, in one sentence that says what to do.
const other = String((await ok("recipe_run", { plugin: "clock-ratchet-click", params: { teeth: 24 } })).object);
await ok("model_place", { objects: [other], to: frame });
await ok("model_place", { object: other, joint: hinge });
const wrong = await call("model_place", { object: wheel, couple: { driven: frame, kind: "ratchet", click: other } });
assert.equal(wrong.ok, false, show(wrong));
assert.match(String(wrong.reason), /was made for a ratchet of 24 teeth.*make the click again with the wheel's numbers/, show(wrong));

// Coupled with no numbers: read from the parts.
const coupled = await ok("model_place", { object: wheel, couple: { driven: frame, kind: "ratchet", click } });
const row = coupled.coupling as { free?: number; click: { teeth: number; tip: number; root: number; armMm: number; liftDeg: number } };
assert.deepEqual([row.click.teeth, row.click.tip, row.click.root], [20, 12, 10.2], show(coupled));
assert.ok(near(row.click.armMm, 10, 1e-4), `the arm read from where its hinge stands: ${show(row)}`);
const read = (coupled.read as string[]).join(" ");
assert.match(read, /Teeth, tip and root: 20 teeth, tip 12 mm and root 10.2 mm, read from Ratchet wheel \(Ratchet wheel v1\)/, show(coupled));
assert.match(read, /Runs free turning back on its hinge/, show(coupled));
assert.match(String(coupled.note), /read from Ratchet wheel/, show(coupled));
console.log(`coupled with no numbers: ${read}`);

// Turned its free way (back, as horology's wheel runs clockwise seen from +Z): the click rides a tooth and drops.
const stored = () => s.assemblies[0]!.couplings!.find((one) => one.kind === "ratchet")!;
await ok("model_place", { object: wheel, angle: -9 });
assert.ok(Math.abs(at(click)!) > 1 && near(at(click), clickAngle(stored().click!, -9)), `half a tooth lifts the click: ${at(click)}`);
await ok("model_place", { object: wheel, angle: -18 });
assert.ok(near(at(click), 0, 1e-6), `after one tooth the click is back in a notch: ${at(click)}`);
console.log(`free way: lifted ${Math.abs(clickAngle(stored().click!, -9)).toFixed(3)} degrees at half a tooth, seated after one`);
// Turned the other way, seated, it holds.
const held = await call("model_place", { object: wheel, angle: -15 });
assert.equal(held.ok, false, show(held));
assert.match(show(held), /turns only back: its click on Frame holds it the other way/);
assert.ok(near(at(wheel), -18) && near(at(click), 0, 1e-6), "nothing moved");
console.log("turned back from a notch: held by the click");
console.log("clock-couple: all passed");
process.exit(0);
