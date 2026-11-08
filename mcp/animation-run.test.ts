import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IDENTITY_POSE } from "../src/model-space.ts";
import type { Assembly } from "../src/assembly.ts";
import { findLust, RecipeHost } from "./recipe.ts";
import { runAnimation } from "./animation-run.ts";

const lust = findLust();
if (!lust) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") throw new Error("lust is required");
  console.log("animation-run: skipped (set LIME_LUST)");
  process.exit(0);
}
const root = fileURLToPath(new URL("..", import.meta.url));
const host = new RecipeHost({ crateDir: join(root, "crates", "lime-recipe"), root: mkdtempSync(join(tmpdir(), "lime-animation-run-")), lust });
const assembly: Assembly = { id: "arm", name: "Arm", members: [
  { object: "body", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] },
  { object: "finger", parent: "body", offset: [0, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1], angle: 0, min: -90, max: 90 } },
] };
const parts = [{ object: "body", name: "Body" }, { object: "finger", name: "Finger" }];
const before = structuredClone(assembly);
const source = `use lime_recipe::{anim::*, Session};
fn main() {
  let mut s = Session::start();
  let rig = s.rig().unwrap();
  let mut a = Animation::new(4);
  a.key(0.0, Pose::rest());
  a.key(1.0, Pose::new().set_all(&rig.group("Finger*"), Aim::Degrees(60.0)));
  s.animate(&a).unwrap();
}`;
const result = await runAnimation(host, source, {}, assembly, () => IDENTITY_POSE, parts);
assert.equal(result.ok, true, JSON.stringify(result));
if (result.ok) {
  assert.equal(result.result.frames.length, 4);
  const last = result.result.frames.at(-1)!.assembly.members[1]!.joint!;
  assert.equal(last.kind === "hinge" && last.angle, 60);
}
assert.deepEqual(assembly, before);
const bad = await runAnimation(host, source.replace('rig.group("Finger*")', 'rig.group("missing")'), {}, assembly, () => IDENTITY_POSE, parts);
assert.equal(bad.ok, false);
assert.ok(!bad.ok && bad.issues?.some((issue) => issue.reason.includes("missing")), JSON.stringify(bad));
console.log("animation-run: real script, sampling, refusal and unchanged rig passed");
