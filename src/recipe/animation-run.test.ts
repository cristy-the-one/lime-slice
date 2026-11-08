import assert from "node:assert/strict";
import type { Assembly } from "../assembly.ts";
import { IDENTITY_POSE } from "../model-space.ts";
import { runAppAnimation } from "./animation-run.ts";
import type { AppRecipes } from "./tauri.ts";
import type { RecipeCall } from "./host.ts";
const assembly: Assembly = { id: "a", name: "A", members: [
  { object: "root", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] },
  { object: "finger", parent: "root", offset: [0, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1], angle: 0, min: -90, max: 90 } },
] };
const before = structuredClone(assembly);
let givenRig = false;
const recipes = {
  build: async () => ({ ok: true, exe: "animation" }),
  run: async (_exe: string, start: Record<string, unknown>, call: RecipeCall) => {
    assert.equal(start.kind, "animation");
    const rig = await call({ id: 1, tool: "rig", line: 2, args: {} });
    givenRig = rig.ok && (rig.result as { members: unknown[] }).members.length === 2;
    const result = await call({ id: 2, tool: "animate", line: 3, args: { fps: 4, keys: [{ t: 0, rest: true }, { t: 1, set: { Finger: 60 } }] } });
    return { ok: result.ok, calls: 2, refused: [], stderr: "", ms: 0 };
  },
} as unknown as AppRecipes;
const output = await runAppAnimation(recipes, "test", "fn main() {}", {}, assembly, () => IDENTITY_POSE, [{ object: "root", name: "Root" }, { object: "finger", name: "Finger" }]);
assert.ok(output.ok, JSON.stringify(output));
assert.ok(givenRig);
if (output.ok) assert.equal(output.result.frames.length, 4);
assert.deepEqual(assembly, before);
console.log("app animation: rig and sampled frames without mutation passed");
